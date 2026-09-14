# Bundled Inter 4.1

Unmodified `web/InterVariable.woff2` and `LICENSE.txt` extracted from the official
[Inter 4.1 release](https://github.com/rsms/inter/releases/tag/v4.1), archive
`https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip`.

SHA-256:

- Archive: `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`
- Font: `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`
- License: `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`

The font is 352,240 bytes, normal style, variable weight 100–900, with an optical
size axis 14–32 (default 14). It is not subsetted or renamed. Preserve the included
copyright and SIL OFL 1.1 license when distributing it. No external font download
is needed during builds. Satoshi and Geist Mono are unchanged.
An identical public license is included at `/fonts/inter/LICENSE.txt` so static
deployments retain the full notice alongside the emitted font asset.

This is not byte-identical to the former Google distribution. Next 15.5.8 computes
Arial fallback metrics from this actual asset: ascent 89.79%, descent 22.36%,
line gap 0%, size adjustment 107.89%. The prior Google metadata used 90.44%,
22.52%, 0%, and 107.12% respectively. Use measured local metrics rather than
copying stale Google overrides. Visual EN/JA/VI acceptance remains required;
Japanese uses the existing system fallback where Inter has no glyph.

Decision: [ADR 0033](../../../../docs/adr/0033-bundled-inter-for-offline-builds.md).
