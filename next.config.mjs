// Set only by the GitHub Pages workflow, to the repo name — Pages serves a
// project at yourname.github.io/repo-name/, not the root. Unset locally, so
// `npm run dev` / `npm run build` behave exactly as before.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Plain static files instead of a server build — required for GitHub Pages,
  // which can only serve files, not run Next's server.
  output: 'export',
  basePath,

  // Strict mode double-invokes effects, which would boot a second renderer and
  // Rapier world and leak the first pair.
  reactStrictMode: false,

  // Stops `next dev` writing AGENTS.md / CLAUDE.md into the project root.
  agentRules: false,

  // Force every `three` import onto the WebGPU build. Without this the addons
  // pull in a second copy of the library and cross-build `instanceof` checks
  // silently fail. Exact match only, so `three/addons/*` still resolves.
  turbopack: {
    resolveAlias: { three: 'three/webgpu' },
  },
  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, three$: 'three/webgpu' };
    config.experiments = { ...config.experiments, topLevelAwait: true };
    return config;
  },
};

export default nextConfig;
