import type { NextConfig } from 'next';

const config: NextConfig = {
  // The engine packages ship raw TypeScript (no build step, per the bun setup),
  // so Next must compile them rather than expecting published JS.
  transpilePackages: ['@diffhawk/core', '@diffhawk/github', '@diffhawk/ingest'],
};

export default config;
