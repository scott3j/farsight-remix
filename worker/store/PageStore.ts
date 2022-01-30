import { json } from 'remix';
import { matchCache, removeCache, updateCache } from '../cache';
import { createLogger } from '../logging';
import { checkSafeBrowsingAPI, getPageDetails, scrapeHTML } from '../scraping';
import type { Env, Page, AsyncReturnType } from '../types';

type PageStatistics = Required<Pick<Page, 'bookmarkUsers' | 'viewCount'>>;

function getPageMetadata(page: Page) {
	return {
		url: page.url,
		title: page.title,
		description: page.description?.slice(0, 700),
		isSafe: page.isSafe,
		createdAt: page.createdAt,
		updatedAt: page.updatedAt,
		viewCount: page.viewCount ?? 0,
		bookmarkCount: page.bookmarkUsers?.length ?? 0,
	};
}

async function createPageStore(state: DurableObjectState, env: Env) {
	const { storage } = state;
	const { PAGE } = env;

	const pageMap = new Map<string, Page>();
	const statMap = await storage.list<PageStatistics>({
		prefix: 'stat/',
	});

	function getStatistics(url: string): PageStatistics {
		return statMap.get(`stat/${url}`) ?? { bookmarkUsers: [], viewCount: 0 };
	}

	async function updateStatistics(
		url: string,
		statistics: PageStatistics,
	): Promise<void> {
		statMap.set(`stat/${url}`, statistics);

		await Promise.all([
			storage.put(`stat/${url}`, statistics),
			updatePage(url, statistics),
		]);
	}

	async function getPage(url: string): Promise<Page> {
		let page = pageMap.get(url) ?? null;

		if (!page) {
			page = await PAGE.get<Page>(url, 'json');

			if (!page) {
				throw new Error(`No existing page found for ${url}`);
			}

			pageMap.set(url, page);
		}

		return page;
	}

	async function updatePage(url: string, update: Partial<Page>): Promise<void> {
		const page = await getPage(url);
		const updatedPage = {
			...page,
			...update,
			createdAt: page.createdAt,
			updatedAt: new Date().toISOString(),
		};

		await PAGE.put(url, JSON.stringify(updatedPage), {
			metadata: getPageMetadata(updatedPage),
		});
	}

	return {
		async refresh(url: string, data: Page) {
			const statistics = getStatistics(url);

			updatePage(url, {
				...data,
				...statistics,
			});
		},
		async view(url: string) {
			const statistics = getStatistics(url);

			updateStatistics(url, {
				...statistics,
				viewCount: statistics.viewCount + 1,
			});
		},
		async bookmark(userId: string, url: string) {
			const statistics = getStatistics(url);

			if (statistics.bookmarkUsers.includes(userId)) {
				return;
			}

			updateStatistics(url, {
				...statistics,
				bookmarkUsers: statistics.bookmarkUsers.concat(userId),
			});
		},
		async unbookmark(userId: string, url: string) {
			const statistics = getStatistics(url);

			if (!statistics.bookmarkUsers.includes(userId)) {
				return;
			}

			updateStatistics(url, {
				...statistics,
				bookmarkUsers: statistics.bookmarkUsers.filter((id) => id !== userId),
			});
		},
		async backup(): Promise<Record<string, any>> {
			const data = await storage.list();

			return Object.fromEntries(data);
		},
		async restore(data: Record<string, any>): Promise<void> {
			await storage.put(data);
		},
	};
}

export function getPageStore(env: Env): AsyncReturnType<
	typeof createPageStore
> & {
	getOrCreatePage: (url: string) => Promise<Page>;
	getPage: (url: string) => Promise<Page | null>;
	deleteCache: (url: string) => Promise<void>;
	refresh: (url: string) => Promise<void>;
} {
	const { PAGE, PAGE_STORE, GOOGLE_API_KEY, USER_AGENT } = env;

	const name = 'global';
	const id = PAGE_STORE.idFromName(name);
	const store = PAGE_STORE.get(id);

	async function request(
		pathname: string,
		method: string,
		data?: Record<string, any>,
	) {
		const searchParams =
			method === 'GET' && data
				? new URLSearchParams(
						Object.entries(data).filter(
							([_, value]) => value !== null && typeof value !== 'undefined',
						),
				  )
				: null;
		const body = method !== 'GET' && data ? JSON.stringify(data) : null;
		const response = await store.fetch(
			`http://${name}.page${pathname}?${searchParams?.toString()}`,
			{
				method,
				body,
			},
		);

		if (response.status === 204) {
			return;
		}

		if (!response.ok) {
			throw new Error(
				`Request ${method} ${pathname} failed; Received response with status ${response.status}`,
			);
		}

		return await response.json<any>();
	}

	return {
		async getPage(url: string) {
			let page = await matchCache<Page>(url);

			if (!page) {
				page = await PAGE.get<Page>(url, 'json');

				if (page) {
					updateCache(url, page, 10800);
				}
			}

			return page;
		},
		async deleteCache(url: string) {
			await removeCache(url);
		},
		async getOrCreatePage(url: string) {
			let page = await PAGE.get<Page>(url, 'json');

			if (!page) {
				page = await scrapeHTML(url, USER_AGENT);

				const [pageDetails, isSafe] = await Promise.all([
					getPageDetails(page.url, env),
					GOOGLE_API_KEY
						? checkSafeBrowsingAPI([page.url], GOOGLE_API_KEY)
						: false,
				]);

				page = {
					...page,
					...pageDetails,
					isSafe,
				};

				PAGE.put(page.url, JSON.stringify(page), {
					metadata: getPageMetadata(page),
				});
			}

			return page;
		},
		async refresh(url: string) {
			const [page, pageDetails, isSafe] = await Promise.all([
				scrapeHTML(url, USER_AGENT),
				getPageDetails(url, env),
				GOOGLE_API_KEY ? checkSafeBrowsingAPI([url], GOOGLE_API_KEY) : false,
			]);

			return await request('/refresh', 'POST', {
				url,
				page: {
					...page,
					...pageDetails,
					isSafe,
				},
			});
		},
		async view(url: string) {
			return await request('/view', 'POST', { url });
		},
		async bookmark(userId: string, url: string) {
			return await request('/bookmark', 'POST', { userId, url });
		},
		async unbookmark(userId: string, url: string) {
			return await request('/unbookmark', 'POST', { userId, url });
		},
		async backup() {
			return await request('/backup', 'POST');
		},
		async restore(data: Record<string, any>) {
			return await request('/restore', 'POST', data);
		},
	};
}

/**
 * PageStore - A durable object that orchestrate page updates
 */
export class PageStore {
	env: Env;
	state: DurableObjectState;
	store: AsyncReturnType<typeof createPageStore> | null;

	constructor(state: DurableObjectState, env: Env) {
		this.env = env;
		this.state = state;
		this.store = null;
		state.blockConcurrencyWhile(async () => {
			this.store = await createPageStore(state, env);
		});
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const logger = createLogger(request, {
			...this.env,
			LOGGER_NAME: 'store:PageStore',
		});

		let response = new Response('Not found', { status: 404 });

		try {
			const method = request.method.toUpperCase();

			if (!this.store) {
				throw new Error(
					'The store object is unavailable; Please check if the store is initialised properly',
				);
			}

			if (method === 'POST') {
				switch (url.pathname) {
					case '/refresh': {
						const { url, page } = await request.json();

						this.store.refresh(url, page);

						response = new Response(null, { status: 204 });
						break;
					}
					case '/view': {
						const { url } = await request.json();

						this.store.view(url);

						response = new Response(null, { status: 204 });
						break;
					}
					case '/bookmark': {
						const { userId, url } = await request.json();

						this.store.bookmark(userId, url);

						response = new Response(null, { status: 204 });
						break;
					}
					case '/unbookmark': {
						const { userId, url } = await request.json();

						this.store.unbookmark(userId, url);

						response = new Response(null, { status: 204 });
						break;
					}
					case '/backup': {
						const data = await this.store.backup();

						response = json(data);
						break;
					}
					case '/restore': {
						const data = await request.json<any>();

						await this.store.restore(data);

						// Re-initialise everything again
						this.store = await createPageStore(this.state, this.env);

						response = new Response(null, { status: 204 });
						break;
					}
				}
			}
		} catch (e) {
			if (e instanceof Error) {
				logger.error(e);
				logger.log(
					`PageStore failed handling ${method} ${url.pathname}; Received message: ${e.message}`,
				);
			}

			response = new Response('Internal Server Error', { status: 500 });
		} finally {
			logger.report(response);
		}

		return response;
	}
}
