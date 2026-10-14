# Third-party notices

mtg-planner itself is licensed under the PolyForm Noncommercial License 1.0.0
(see [LICENSE](LICENSE)). The container image also contains, or downloads at
runtime, the third-party components below. Each keeps its own license; the
PolyForm license does not apply to them.

## bmurdock/scryfall-mcp (bundled in the image)

The Scryfall MCP server is built from source at a pinned commit into
`/opt/scryfall-mcp`. Its license file is copied to `/opt/scryfall-mcp/LICENSE`,
and its npm dependencies under `/opt/scryfall-mcp/node_modules` carry their
own license files.

Source: <https://github.com/bmurdock/scryfall-mcp>

```
MIT License

Copyright (c) 2025 Brian Murdock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Tesseract OCR and traineddata (Debian packages in the image)

`tesseract-ocr` and the language data packages (`tesseract-ocr-eng`, `-deu`,
`-fra`, `-ita`, `-spa`, `-por`, `-jpn`, `-chi-sim`, `-chi-tra`, `-kor`,
`-rus`, `-osd`) are licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Source: <https://github.com/tesseract-ocr/tesseract> and
<https://github.com/tesseract-ocr/tessdata_fast>. Tesseract uses Leptonica
(BSD-2-Clause style license).

The image also contains `/usr/local/bin/mtg-ocr`, built from this
repository's `native/mtg-ocr.c` and dynamically linked against the same
Debian packages' libraries: the Tesseract API (`libtesseract5`, Apache
License 2.0) and Leptonica (`liblept5`, BSD-2-Clause style license). Both
libraries are used unmodified; their headers come from `libtesseract-dev` and
`libleptonica-dev` at build time only.

## libjpeg-turbo (Debian package in the image)

`djpeg` comes from `libjpeg-turbo-progs`. libjpeg-turbo is covered by the
Independent JPEG Group's license, the Modified (3-clause) BSD License and the
zlib License. This software is based in part on the work of the Independent
JPEG Group. Source: <https://libjpeg-turbo.org/>.

The full copyright and license text of every Debian package in the image,
including the ones above and the Node.js base image's packages, is in
`/usr/share/doc/<package>/copyright` inside the image.

## Node.js (base image)

The image is based on the official `node:24-slim` image. Node.js is licensed
under the MIT License
(<https://github.com/nodejs/node/blob/main/LICENSE>); npm and its bundled
modules carry their own licenses under `/usr/local/lib/node_modules/npm`.

## Claude Code CLI (installed at runtime, NOT redistributed)

The Claude Code CLI (`@anthropic-ai/claude-code`) is proprietary software,
© Anthropic PBC, all rights reserved. It is **not** part of the mtg-planner
source code or the published image. On start, the container's entrypoint
downloads the pinned version (`CLAUDE_CODE_VERSION`) from the npm registry
into the `/claude` volume of your own installation. Your use of it is
governed by Anthropic's terms:
<https://www.anthropic.com/legal/commercial-terms> and
<https://www.anthropic.com/legal/consumer-terms>, plus the license in the
package's README. You authenticate it with your own Claude subscription token.

## Scryfall data and images

Card data, prices and images are fetched from [Scryfall](https://scryfall.com/)
at runtime under the [Scryfall API guidelines](https://scryfall.com/docs/api)
and are not bundled with mtg-planner. Scryfall's images are used unaltered
for display; downloaded reference images are only used to compute local
fingerprints and are not re-published. mtg-planner is not produced by or
endorsed by Scryfall.

The card detector's data files (`public/det/template.mjs`: mean card layout
templates; `public/det/orientw.mjs`: orientation classifier weights) are
small statistics derived from Scryfall card images. They contain no image,
and no card image can be reconstructed from them.

## Magic: The Gathering

Magic: The Gathering, card names, card text, mana symbols and card images are
© Wizards of the Coast LLC. mtg-planner is unofficial Fan Content permitted
under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy)
and is not approved or endorsed by Wizards of the Coast.
