# Contributing to SystemFabric

Thank you for considering a contribution to SystemFabric.

## License of contributions

Unless a maintainer has agreed otherwise in writing, contributions submitted
for inclusion in SystemFabric are intended to be distributed under the
project's GNU General Public License, version 2 or (at your option) any later
version (`GPL-2.0-or-later`). Contributors retain copyright in their original
contributions unless a separate written agreement provides otherwise.

By submitting a contribution for inclusion, you confirm that you have the right
to submit it under these terms and that, to the best of your knowledge, it does
not knowingly violate another party's rights. No separate contributor license
agreement is required by this policy as written; that may change only through
an explicitly published project policy.

## Copyright and third-party material

- Do not remove existing copyright or license notices.
- Do not submit code, documentation, media, fonts, or other assets unless you
  have the rights needed to contribute them under the applicable terms.
- Clearly identify third-party material and its license. Keep compatible
  license texts and attribution notices with the material.
- The vendored EnginEx project and other separately licensed dependencies keep
  their own license terms; see `THIRD-PARTY-NOTICES.md` and component-level
  notices.

## Secrets and security

Never commit API keys, passwords, tokens, private certificates, production
customer data, or other secrets. Use documented environment variables and
fake, clearly non-secret values in tests. If you suspect a credential was
committed, report it privately to the maintainers and rotate it promptly when
it may be real; do not open a public issue containing the credential.

## Pull requests

Explain the problem and intended behavior, add or update tests where practical,
and document security, compatibility, migration, or configuration implications.
Do not describe a change as production-certified unless the release gates and
evidence support that claim.
