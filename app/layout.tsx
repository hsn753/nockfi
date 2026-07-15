import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Geist_Mono } from 'next/font/google'
import localFont from 'next/font/local'
import { Providers } from '@/lib/providers'
import './globals.css'

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})
// Brand UI sans from the Figma file — Helvetica Now Display (licensed TTFs
// supplied by design, served locally).
const helveticaNow = localFont({
  variable: '--font-helvetica-now',
  display: 'swap',
  // Subset woff2 (Latin) — was uncompressed TTF (~150KB each, ~900KB total); now ~23KB
  // each. See app/fonts. `display: swap` paints text immediately in the fallback, then
  // swaps — no invisible-text delay on slow mobile connections.
  src: [
    { path: './fonts/HelveticaNowDisplay-Light.woff2', weight: '300', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-Regular.woff2', weight: '400', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-RegIta.woff2', weight: '400', style: 'italic' },
    { path: './fonts/HelveticaNowDisplay-Medium.woff2', weight: '500', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-Bold.woff2', weight: '700', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-ExtraBold.woff2', weight: '800', style: 'normal' },
  ],
})
// The display serif for the wordmark, hero, and section headings — Merriweather,
// matching the Figma screens ("Hey, I'm Robin…", card titles, wordmark). Subset woff2
// with the full weight axis kept: 4.6MB TTF -> ~770KB. The italic variant (another 4.6MB
// TTF) was dropped — no serif-italic is used anywhere in the app.
const merriweather = localFont({
  variable: '--font-merriweather',
  display: 'swap',
  src: [
    { path: './fonts/Merriweather-Variable.woff2', weight: '300 900', style: 'normal' },
  ],
})

export const metadata: Metadata = {
  title: 'Nock — your AI agent concierge',
  description:
    'Nock is an AI agent concierge for crypto. Chat with Robin to put your assets to work across yield, perps, swaps, stock tokens, and vaults.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0a0a',
  userScalable: false,
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark ${helveticaNow.variable} ${geistMono.variable} ${merriweather.variable} bg-background`}
    >
      <body className="font-sans antialiased">
        <Providers>
          {children}
        </Providers>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
