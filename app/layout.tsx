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
  src: [
    { path: './fonts/HelveticaNowDisplay-Light.ttf', weight: '300', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-RegIta.ttf', weight: '400', style: 'italic' },
    { path: './fonts/HelveticaNowDisplay-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-Bold.ttf', weight: '700', style: 'normal' },
    { path: './fonts/HelveticaNowDisplay-ExtraBold.ttf', weight: '800', style: 'normal' },
  ],
})
// The display serif for the wordmark, hero, and section headings — Merriweather,
// matching the Figma screens ("Hey, I'm Robin…", card titles, wordmark).
const merriweather = localFont({
  variable: '--font-merriweather',
  src: [
    { path: './fonts/Merriweather-Variable.ttf', weight: '300 900', style: 'normal' },
    { path: './fonts/Merriweather-Italic-Variable.ttf', weight: '300 900', style: 'italic' },
  ],
})

export const metadata: Metadata = {
  title: 'Nock — your AI agent concierge',
  description:
    'Nock is an AI agent concierge for crypto. Chat with Robin to put your assets to work across yield, perps, swaps, stock tokens, and vaults.',
  generator: 'v0.app',
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
