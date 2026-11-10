# Changelog

## [0.6.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.5.0...claude-tty-acp-v0.6.0) (2026-11-09)


### Features

* adopt Paseo 0.13.0–0.14.0 ([5eea4f5](https://github.com/sleeyax/paseo-plugins/commit/5eea4f59141a7565c435bf808ad3a9aa13728a1c))
* **claude-tty:** deprecate the plugin and its adapter ([2a12f13](https://github.com/sleeyax/paseo-plugins/commit/2a12f13999b71ae30e25c542ece2a562a8369d2f))
* **claude-tty:** deprecate the plugin and its adapter ([fe949a3](https://github.com/sleeyax/paseo-plugins/commit/fe949a3a417d79865d24868e3ca899d79dd4b1a6))
* **claude-tty:** keep Paseo's idle cleanup from stopping a running Claude ([90670d3](https://github.com/sleeyax/paseo-plugins/commit/90670d3c8f62a31d9d5f990bc2c6f311dbf140aa)), closes [#168](https://github.com/sleeyax/paseo-plugins/issues/168)


### Bug Fixes

* **claude-tty:** keep the idle timeout from stopping Claude while its background work runs ([#170](https://github.com/sleeyax/paseo-plugins/issues/170)) ([3a2c1c7](https://github.com/sleeyax/paseo-plugins/commit/3a2c1c7d11ef9769ea31ab9d03b22ea91fdfa13f))
* **claude-tty:** restore a resumed session's earlier prompts ([f53f51e](https://github.com/sleeyax/paseo-plugins/commit/f53f51ec9d0e6e95498345c6ecd0e9e0c80d7962)), closes [#166](https://github.com/sleeyax/paseo-plugins/issues/166)

## [0.5.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.4.0...claude-tty-acp-v0.5.0) (2026-10-21)


### Features

* **claude-tty:** link owner/repo[#123](https://github.com/sleeyax/paseo-plugins/issues/123) issue references in Claude's replies ([#154](https://github.com/sleeyax/paseo-plugins/issues/154)) ([7ea605c](https://github.com/sleeyax/paseo-plugins/commit/7ea605c7f85c0fbc78c3b5d8e3276a79cf59387d))


### Bug Fixes

* **claude-tty:** keep a question card open in a turn held for background work ([#157](https://github.com/sleeyax/paseo-plugins/issues/157)) ([3af2e78](https://github.com/sleeyax/paseo-plugins/commit/3af2e785a6ce0238e58c701ffb053a2b2c691496))
* **claude-tty:** send a prompt as the user's own words instead of one collapsed paste ([#140](https://github.com/sleeyax/paseo-plugins/issues/140)) ([421d071](https://github.com/sleeyax/paseo-plugins/commit/421d0714b902ba6ca932e020c985cce21db7dd2e))
* **claude-tty:** show the text Claude writes above a question before the question ([#158](https://github.com/sleeyax/paseo-plugins/issues/158)) ([4e62a73](https://github.com/sleeyax/paseo-plugins/commit/4e62a73e4139613edd81bfd59cc8222c0e5d189c))

## [0.4.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.3.0...claude-tty-acp-v0.4.0) (2026-10-07)


### Features

* **claude-tty:** open the panel as a screen from a sidebar header item ([3704181](https://github.com/sleeyax/paseo-plugins/commit/370418165da836db350781636d7fbe82352a43b7)), closes [#126](https://github.com/sleeyax/paseo-plugins/issues/126)

## [0.3.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.2.0...claude-tty-acp-v0.3.0) (2026-10-07)


### Features

* **claude-tty:** open a subsession for each background command ([f546d4f](https://github.com/sleeyax/paseo-plugins/commit/f546d4f3df1fd12d7cf2fc6835f5a0e0be4cae3c))
* **claude-tty:** show a background command's output on its card ([7722832](https://github.com/sleeyax/paseo-plugins/commit/7722832a1a3a760b6009b80ad0dab9910c07fa8f))
* **claude-tty:** show background commands like subagents ([964366f](https://github.com/sleeyax/paseo-plugins/commit/964366f90128d4cb3d2ee537750a975b023d53ae))

## [0.2.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.1.0...claude-tty-acp-v0.2.0) (2026-10-03)


### Features

* **claude-tty:** offer Opus 5.5 and Sonnet 5.5 ([d669cf1](https://github.com/sleeyax/paseo-plugins/commit/d669cf1c7f5235a4f7054098503661c58ea39d42))


### Bug Fixes

* **claude-tty:** run a slash command sent with an attachment ([#110](https://github.com/sleeyax/paseo-plugins/issues/110)) ([fa95c99](https://github.com/sleeyax/paseo-plugins/commit/fa95c990d69d5a198a42d6a4cf7cfb1bd62ab0c2))

## [0.1.0](https://github.com/sleeyax/paseo-plugins/compare/claude-tty-acp-v0.0.1...claude-tty-acp-v0.1.0) (2026-09-25)


### Features

* **claude-tty:** read settings through the 0.9 handle and push them to the adapter ([#80](https://github.com/sleeyax/paseo-plugins/issues/80)) ([ac7e9ee](https://github.com/sleeyax/paseo-plugins/commit/ac7e9ee1df7f7fe2a7df2a89aaadf2427b985f76))
