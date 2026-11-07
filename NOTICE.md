# Third-party notices

The protocol descriptor `protocol/hoymiles.desc` and cryptographic framing reference are derived from **suaveolent/hoymiles-wifi v0.5.5**, MIT, Copyright (c) 2023 suaveolent. The full license is in `protocol/LICENSE-suaveolent`.

The additional warning, alarm and event protocol definitions originate from the installed **Eistee82/ioBroker.hoymiles 0.5.0** distribution, MIT, Copyright (c) 2026 Eistee82. The full license is in `protocol/LICENSE-Eistee82`.

The German alarm-code lookup in `lib/alarm-codes.json` is adapted from the alarm-code data in the same MIT-licensed distribution. Model-dependent meanings are explicitly labelled. The HMS-W manual (2023-08, section 6.1) was used to check HMS-W descriptions. Additional code identities 152, 171 and 223 were checked against the OpenDTU alarm parser; no parser implementation is included.

Project layout and GitHub workflows follow **BeSiRe1/ioBroker.faikin**, MIT. Device communication and state handling are implemented specifically for this adapter.

This project is independent and is not an official Hoymiles product.
