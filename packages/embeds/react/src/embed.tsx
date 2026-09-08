"use client";

import { DubEmbedOptions, init } from "@dub/embed-core";
import { HTMLProps, memo, useEffect, useRef } from "react";

type Options = Omit<DubEmbedOptions, "token">;

type DubEmbedProps = {
  token: DubEmbedOptions["token"];
  data: DubEmbedOptions["data"];
  options?: Options;
} & HTMLProps<HTMLDivElement>;

export const DubEmbed = memo(
  ({ token, data, options, ...rest }: DubEmbedProps) => (
    <DubEmbedInner options={{ ...options, token, data }} {...rest} />
  ),
);

function DubEmbedInner({
  options,
  ...rest
}: { options: DubEmbedOptions } & HTMLProps<HTMLDivElement>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  const optionsFingerprint = JSON.stringify(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!rootRef.current) return;

    const { destroy } =
      init({
        root: rootRef.current,
        ...optionsRef.current,
      }) || {};

    return () => destroy?.();
  }, [optionsFingerprint]);

  return <div {...rest} ref={rootRef} />;
}
