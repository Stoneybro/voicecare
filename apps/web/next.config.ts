import type { NextConfig } from "next";

// Stage 1 has no workspace packages yet. Stage 3 reintroduces @voicecare/shared with
// transpilePackages when the shared decision-logic package returns.
const nextConfig: NextConfig = {};

export default nextConfig;
