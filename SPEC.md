# Web module

## §web-host Hosting

An optional Agent Plugin declares one native Plurnk module. It uses the public
module lifecycle and HTTP registration seam, never a separate listener or process.
The daemon owns routing precedence, startup readiness and shutdown.

| Configuration | Behavior |
|---|---|
| PLURNK_WEB_ENABLED=1 | Claim and register `/` on the daemon's existing listener. |
| PLURNK_WEB_ENABLED=0 | Inert module: no route claims or registration. |
| Invalid value | Existing configuration diagnostic; no web module activation. |
| Package absent | No web routes. |

The package's .env.defaults owns the default. Installation is opt-in; the service
does not depend on this package. More-specific mounts retain their ownership.

## §web-assets Static resources

| Request | Response |
|---|---|
| GET `/` | Packaged HTML document. |
| GET `/app.js`, `/vendor/otm.js` | Packaged browser ES modules. |
| GET `/locales/en.json`, `/vendor/OTM-LICENSE.txt` | Packaged translation and license. |
| HEAD on any served path | Same status and headers as GET, without a body. |
| Other path | 404, never an HTML fallback or directory listing. |
| Method other than GET/HEAD | 405 with `Allow: GET, HEAD`. |

Query strings do not select assets. Paths select an explicit resource map, never
filesystem paths derived from the request. Only packaged public assets are served;
configuration, source, credentials and workspace files are not public resources.
Assets are loaded during module startup: missing package bytes fail startup rather
than leaving a partially functioning page. Responses declare their media type,
byte length and `X-Content-Type-Options: nosniff`.

## §web-document Document

The document says Hello world in semantic HTML and initializes OTM from locally
packaged ES modules. It remains readable without JavaScript. It has no stylesheet,
theme, client routing, persistent browser state, external asset requests or agent
interface. No browser credential or daemon state is embedded in the document.

## §web-package Package boundary

The npm archive includes the Agent Plugin manifest, native module, defaults,
document and its complete browser dependency graph, including OTM's license.
Tests and build tooling are not runtime inputs. Verification installs the archive
beside a published service in an isolated environment and exercises actual module
discovery, routing and browser execution.

Upstream contracts: [module lifecycle and mounts](https://github.com/plurnk/plurnk-service/blob/main/plurnk-modules/SPEC.md),
[Agent Plugins](https://agent-plugins.org/), and OTM's installed README.
