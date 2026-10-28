import { inflateSync } from "node:zlib";

// Alpha masks rasterized from nf-cod-openai (EC81) and nf-cod-claude (EC82), Nerd Fonts 3.5.
// Codicons by Microsoft and contributors: CC BY 4.0; see provider-icon-data.LICENSE.
// The 48px advance within a 64px canvas gives 1.5x text sizing in a two-column image slot.
export const providerIconSize = 64;
const compressed = {
  openai:
    "eJztlntM1lUYxx9AiIvcwkw3QoIKakW1GjhlFaQwnC6IamS1LmIta8ZqaSMLypmAUaNpwzHtjy6i/ZEtsIDZ0ilUs4vCVG41QE0D4xKXl8v7ftr5/X4v8HvfH5f4qzW//7znOb/zOe85z3me5xyRK/q/ymPuqFdm2ZkeBut3p3rOBX/yd5xqfPBf08FfaGRfe5/2+5m/SFBE2Kx3E3oCOJgZIiI3bL4A/HiwG/j7yCsLZ4N7HYPWeKc1/8D4TmBwh//MfD78EOo05m1Uf835uuNNNtVojpkJXzRE+7VOI6kBGCiIUm2/tK+ArtgZ+O3wsNGM+BxwfBI+/i25E1oDp+ebOas3fN8YBL5PmPwx6hzsmo72SocirZX+G9DxmMupxdsYvX5KOnBrJ/ComkctffAtw93he75bbQx51zm/he69qJ1SsojcpeLmOmMjWwaAimjNCBuhdQo8awQYguUich+UGN0ZaiOAbau2msNgHUaJNmhZlafzSZCt9d5So9hjJf1AW6Z+PolWeEAbVAfIm+P/r/iQ90eB9iyR8E/VPNWxkgNOX5hUAL/6iYn3zP4TsL+te3H5T8BIURGkWeCBfdjjxMQvU4Ba/B36EM/sS3qHKSQMZcM+MfFNamhFBTC262p9UHCxcjELLPh9xrImeKAhRSRFpUDXs0YZivkaKLbgGyHIhe983kv1eG1QQXViqTHwiSF42Z3vpkfM/H5VQDSF7Fd59JGRlaljjNzqxg9w2YXPNjkH6M2Zp1nboNKNb8fua/ArJ8ePpvVQpQKoIUlZ/p1wkytfBcvU7+twKsGCf2jxHjvwojILYIsr/5rh1mS10vJId14krg6+UeZSqHHlIx10awfwjPK2rdKClzuhWpm+djrcHHAAPtAaoSUq5l39p/gYg5fLDLjxUQM4HtGbN1cp3nx+Jr6XbjdenoLRF4xytabZNX4m80HQ5M5LLnDUyBWfTX2T49fMr4JyC95b7du+28iORXsdzvxxNJr5cnjOgo/Vs7P7JT3M5O5avaMuYb2Jj7PTH2zB3w+F24aA0yma7ZuvIqZjrYfZ/76/wHsWuKyGHInU7ssvo0XS1RtgIM9v4vw13rcC/tAixVWJsF1E7vlZBdCHqm46Ptbvrkl8/EkYXWGFywIjLD3X6fcAdc5CtWOcV5ewfd2UV9+IfnEHFg5D+1ojGBaW2SFVRG7XZv3LqnxqemfiboreudnPiIRXe1XhVsm9Up1OsVELLRQ+jM21tqa3ABce19qb4GnvKWl9nxdND4y4w8Bw4XzdOk7X9K85vwboyRg3rykdAw45a00ylE2Liyw5DxzJ0I53SX4P0LLG+S34NHa3suWqiJPKxaMttbUdqtGfe5XzS0AN7JwJF/HJ0x+Nug6N14Db6uGUVmFnUujGb9UUfZVHgUu5N6qEf6DcDmcWyyzlERYRJOJdqj9j21QAQM2sXp8mpem1Q+nchrm85j1WlNYP0nN2b5bPHGjnJHNHr0j+4/oHgqZQig==",
  claude:
    "eJztVltMVFcUXTNIIaDiKzUYCbY6IjLEB3GMqTStaZVqrA+00pSIMVoBX2mb2JhiSWM/pKFio6HNpCofmLY+ArYmLRioHz4mERUNEIk0VQIaH7wcClRmZplzzp2BAefemfrXsD5m1t5nr3PP3Xufcw8wghH4I8/ZWBg+YMbMDS1BH5Dkpz7z7fvu3JD0fwt98yivWUM+iw9Ff1bomalZScKYEoo+V+prNWsZyR5TKPqY+3KCpcrKIFmvjSQf+s4WxATrpf68MnJI/qboO31k/aDCBESlnGCe5F+QLJTM2iW8u3V0r2j/VpeI/FnyQm8uY5vlrFmB5V+xvUhNUSwi3UmCHiU5G0D0NSlnbEC5TQxfmy7opA7BTwpaTvaEAaYzSn4w8OOnyoCu9YJ/IqgnWbWPA8B+JXfopa9exRRHAOGNgp0B8JD8Htightp1G3HWbRV1wwKslAuYgwgP+TFSetTISj05EF2iwp5+qNWwDNNJLhjdpPyqjnrIdKpIe6Sq4fxUsj/yuHJeDqJ3LJdU7K0EWcNjG8iGzcrVFmcsB8y7/5HR3QfEb6sshIRnRTByAK9X+zRknY8VDURE6u9H07anHIbmaDE0xpZV8GuT+/Y6/SXE/T5MvwqWTfZ6j2ZVGr1EVvsQfcWjwVb20Pg1f5y0F+zNyUhbmDBZ7qHYcgaAs/LLJd6d6oPsVy+6my6eOry/d7j0r1P56QlhL1qvrY8GuFeSpdcAE9LSM7fu3JN/4JC9tKzi4vXGFr8V/fBuTEiHKPBG/5AF9Hd2dLQ1Oc6VFG554Sv4YdovftqOf/3MmsCnkMTYgiHpaE1O3XtOHkoK1XrqUTmy1nfyXIMmsAAma3bpXWU268iXy3PI9U3iI7J2YAKrGp2acaTWeTjwOZSkDv+bKVE3ybrsQSlI9cUEroR5j0xUX144Ssle6xEyXziq7pG9q2GE+AvyUZcSge0kc1FFTisVD59/lXRtNZCv6ZS9sssMLHpGlgMPyMjJIu9no8pI7tPXy5arELl5tYVsmYjxZDuwTbgzzAfF2W7W0zeQbfL7FlZNut8C3iQbANMVko8nYbuLPB2ho5+wcXGMJAUkvwawg6wCMFc0wk/A0ifknypCF2tJXhEXIDt5QjiKxBu8D8TXGLSexMwusvM1wRzaN2OMyEzrOCDiRzqNNk90HeleK5i5m/xM+uTn7Khg6WlGjz9OejZLNoPkR/BdIzjOcOkAUkjuUHQdySWKhl8mGczlCcvc/Fyj35JM1HjcEzoTgtHD9p6XOUiO9xqxi6MQGkxOsg8vgeKBq+N/wtiqcsvL6EeA/zueAziGkpg=",
} as const;

export type ProviderIconName = keyof typeof compressed;

const masks = new Map<ProviderIconName, Uint8Array>();

export function providerIconMask(name: ProviderIconName): Uint8Array {
  let mask = masks.get(name);
  if (!mask) {
    mask = inflateSync(Buffer.from(compressed[name], "base64"));
    if (mask.length !== providerIconSize ** 2) {
      throw new Error("Invalid embedded provider icon mask.");
    }

    masks.set(name, mask);
  }

  return mask;
}
