# @nubjs/extensions

A drop-in replacement for `@yarnpkg/extensions` carrying 1040 packages instead of 159.

```js
import { packageExtensions } from '@nubjs/extensions';
// Array<[selector, { dependencies?, peerDependencies?, peerDependenciesMeta? }]>
```

Every rule from `@yarnpkg/extensions@2.0.7` is included verbatim, so nothing that works today stops working. The rest comes from scanning the 10000 most-downloaded packages on npm for imports their manifests never declare.

Method, per-entry evidence and the ready-to-paste config blocks: https://github.com/nubjs/package-extensions
