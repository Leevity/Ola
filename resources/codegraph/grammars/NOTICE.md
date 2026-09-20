# CodeGraph grammar assets

The Haskell and Julia WASM assets in this directory are built from the
Tree-sitter grammars below and are distributed under their upstream licenses:

- Haskell: `https://github.com/tree-sitter/tree-sitter-haskell.git` at
  `c30d812bc90827f1a54106a25bc9a6307f5cdcec`
- Julia: `https://github.com/tree-sitter/tree-sitter-julia.git` at
  `e0f9dcd180fdcfcfa8d79a3531e11d99e79321d3`
- Razor: `https://github.com/tris203/tree-sitter-razor.git` at
  `d4664e409caaea12f73c9525484e3cf88b1cf718`

The packaged WASM files are generated assets; their SHA-256 values are recorded
in the migration acceptance report and should be refreshed whenever the pins
change.
