import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    tw?: string;
  }
  interface SVGAttributes<T> {
    tw?: string;
  }
  interface ImgHTMLAttributes<T> {
    tw?: string;
  }
  interface StyleHTMLAttributes<T> {
    jsx?: boolean;
    global?: boolean;
  }
}

export {};
