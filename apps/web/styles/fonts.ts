import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";

export const satoshi = localFont({
  src: "../styles/Satoshi-Variable.woff2",
  variable: "--font-satoshi",
  weight: "300 900",
  display: "swap",
  style: "normal",
});

export const inter = localFont({
  src: "./inter/InterVariable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const geistMono = GeistMono;
