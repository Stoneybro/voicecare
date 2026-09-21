import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The shared package ships TypeScript source (it is the single source of truth for the
  // draft schema used by the agent tools, the backend, and the browser) so Next.js compiles it.
  transpilePackages: ["@voicecare/shared"],
};

export default nextConfig;
