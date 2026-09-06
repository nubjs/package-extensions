// @nubjs/extensions 1.0.0 — generated 2026-09-06, do not edit.
// 812 packages, 1190 undeclared dependencies found by scanning
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
