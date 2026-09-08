"use client";

import { BlurImage } from "@dub/ui";

import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";

export function ZoomImage({
  src,
  alt,
  width,
  height,
  className,
  ...props
}: React.DetailedHTMLProps<
  React.ImgHTMLAttributes<HTMLImageElement>,
  HTMLImageElement
>) {
  if (!src) return null;

  return (
    <Zoom
      zoomMargin={45}
      zoomImg={{
        ...props,
        src,
        alt,
        className: className ?? "rounded-lg border border-gray-200",
      }}
    >
      <BlurImage
        src={src as string}
        alt={alt ?? ""}
        width={typeof width === "number" ? width : Number(width) || 800}
        height={typeof height === "number" ? height : Number(height) || 600}
        className={className ?? "rounded-lg border border-gray-200"}
      />
    </Zoom>
  );
}
