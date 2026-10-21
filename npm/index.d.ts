// @nubjs/extensions 1.0.34 — generated 2026-10-21, do not edit.
// 760 packages, 1117 undeclared dependencies found by scanning
// the 10000 most-downloaded npm packages, plus every rule from
// @yarnpkg/extensions@2.0.7.
// https://github.com/nubjs/package-extensions

export interface PackageExtensionData {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** Selector-to-extension pairs, in the shape `@yarnpkg/extensions` publishes. */
export declare const packageExtensions: Array<[string, PackageExtensionData]>;
