# Security Policy

## Supported versions

Chaos Proxy has not had a stable release yet. Until `1.0.0` is published, only the latest commit on
`main` is supported: fixes land there, and there are no backports to older tags.

| Version         | Supported |
| --------------- | --------- |
| `main` (latest) | Yes       |
| Anything older  | No        |

## Scope

Chaos Proxy is a local development tool. It binds to `127.0.0.1` only, that is deliberately not
configurable, and it is not meant to be run in production or exposed to a network. Reports are
most useful when they describe something that harms a developer running it locally — for example
a config file that can cause code execution, a way to make the proxy reachable off the loopback
interface, or credentials leaking into output.

Chaos Proxy breaking traffic on purpose is the product, not a vulnerability.

## Reporting a vulnerability

Please do not open a public issue, and please do not include details in a public comment or pull
request.

GitHub's private vulnerability reporting is not currently enabled on this repository, and there is
no published security contact. Until one of those exists, open a minimal issue asking for a private
contact — no version numbers, no reproduction, no description of the flaw — and the details can be
exchanged privately from there.

Please allow time for a fix before disclosing publicly. This is a small project maintained in
spare time, so an acknowledgement may take several days.
