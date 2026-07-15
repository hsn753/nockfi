/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Rewrite barrel imports (e.g. `import { Menu } from 'lucide-react'`) to per-file imports
  // so only the icons/helpers actually used get bundled, not the whole package — trims the
  // initial JS the browser must download and parse on first load.
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
}

export default nextConfig
