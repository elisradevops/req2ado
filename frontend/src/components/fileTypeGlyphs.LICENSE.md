# Fluent 2 System Icons: source and licence

The file-type glyphs in `fileTypeGlyphs.generated.ts` are path data from Microsoft's Fluent 2 System Icons
(<https://github.com/microsoft/fluentui-system-icons>, the set behind <https://fluent2.microsoft.design/iconography>), filled style, native 20 px
and 32 px drawings, unchanged. `scripts/sync-file-type-glyphs.mjs` refreshes them (run by hand: `node --use-system-ca
scripts/sync-file-type-glyphs.mjs`; review the diff before committing). The app never fetches them at runtime.

They are used under the MIT licence below, which requires this notice to travel with them.

---

MIT License

Copyright (c) 2020 Microsoft Corporation

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
