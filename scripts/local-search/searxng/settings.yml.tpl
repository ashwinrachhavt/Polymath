# Template for scripts/local-search/searxng/settings.yml.
# `make search-up` copies this and substitutes __SEARXNG_SECRET__ from
# .env.local-search when the generated file is absent. Edit here, not there.
use_default_settings: true

general:
  instance_name: "Polymath Search"
  privacypolicy_url: false
  donation_url: false
  contact_url: false
  enable_metrics: false

server:
  secret_key: "__SEARXNG_SECRET__"
  limiter: false
  public_instance: false
  image_proxy: false
  bind_address: "0.0.0.0"
  port: 8080

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en"
  formats:
    - html
    - json

ui:
  static_use_hash: true
  default_locale: "en"
  query_in_title: true
  infinite_scroll: false

engines:
  - name: google
    engine: google
    categories: [general]
    shortcut: g
    disabled: false

  - name: duckduckgo
    engine: duckduckgo
    categories: [general]
    shortcut: ddg

  - name: brave
    engine: brave
    categories: [general]
    shortcut: br

  - name: wikipedia
    engine: wikipedia
    categories: [general]
    shortcut: wp

  - name: github
    engine: github
    categories: [it]
    shortcut: gh

  - name: stackoverflow
    engine: stackoverflow
    categories: [it]
    shortcut: so

  - name: arxiv
    engine: arxiv
    categories: [science]
    shortcut: ar

  - name: pypi
    engine: pypi
    categories: [it]
    shortcut: py
