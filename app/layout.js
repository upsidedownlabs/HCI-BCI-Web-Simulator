import '../style.css';

export const metadata = {
  title: 'Tello Drone Simulator',
  description: 'Mobile-optimised 3D drone simulator — Three.js (WebGPU/WebGL) + Rapier physics',
  icons: { icon: 'data:,' },
};

// `maximumScale`/`userScalable` stop a double-tap on a control zooming the page
// instead of repeating the input. `viewportFit` lets the overlay run under a notch.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#080d15',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>{children}</body>
    </html>
  );
}
