// Next.js loads this file automatically when it starts the app.
// The preload files are prepared earlier by the `dev` and `start` wrapper scripts so browser
// clients can keep hitting the fast static file in `public/`. This hook stays empty to avoid doing
// filesystem work twice during process startup.
export async function register(): Promise<void> {}
