import { inflateSync } from "node:zlib";
import { icons } from "../icons.ts";

// Cropped 128px alpha masks from Nerd Fonts 3.5.0: nf-md-robot_outline (F167A),
// nf-cod-terminal (EA85), and nf-cod-folder (EA83), with 8px minimum padding.
// These are the same glyphs used by compact UI, not separately drawn substitutes.
// Material Design Icons: Apache-2.0; Codicons: CC BY 4.0. See state-icon-data.LICENSE.
export const stateIconSize = 128;
const compressed = {
  robot:
    "eJztmltI1Fkcx4+XqVHzIfGlHcNZuqyaVAttW1CYQlBhrmskvkT4ECzOixETSJmzUASlFcQu7IMZkrYi1oPbmLsP6kjsDihjW1GNEbXZQxeHpgbD2/x3xpxzdzz/yxw39v99a873+/vIv/M/1z8ApkyZMmXK1OeldUdb3O6Wo+uWhv51rzKv3s1LgK+ZVqCma6TjTymETknGH1QoHZSKz3xN819nyuSfpPGKclIm/y7LvysRn8XiFSVLHr+Qxy+Ux9/O42+Xx8/j8fPk8VM/sviPqfL4wM3y3RLxoILlfy+Tn+Sl8d4kmXyQ957Ev/9KKh6AoiCODxZJxkeewB2EvyPx3YNKRvzkJcCDJMSX2/dM/v+Yb9tZ6XDWN0TkQvzoPxvqnY7KnbYEoq17znqIUYenoOfsHmsC4JbyrtBi7JhCXeUWY+nZrlei8E965co2jr7y3IQ6elQT51YaQ092BNTTowo4jBiXC5ipXlzeAt34Gg2PHmlC58bY2qqHHlWrnpcx6y+9eEX5U/u+6Iv7vIIhv9fTx5HHO8odIe6v0ojPfsjUGj6zL+4Ia9t3ZpgJPdQ2FGQMUXVeNuSK5HIbXlLBoQwN+KQussjYkWWi0WVHxshsl4YJ8gRRYfZ8mppw+vlZIn5CNX7bNJ5/skNtfscTPD+9TWXcOorHb69Qiwcg8zZeYVTlMHAaD7do2tqmtuA1TqvKrpnEoj9poUf1M1Zkco2a5HUs2Z2ilZ/yG1bmuorgxjDK+bS8vPPK8KE64Y3iOWzWmdygHQ/ABuz/sVU4tWoKpXQeK2IHlVPC88BxFLqn81Qn9R6qdVw09ABlSvXhAShFtR4IRtZjnU8vHgCsC64XSxxDicP6+YdRtWNiiVsw8CFdPz/9Ayx3SyiQhJbbasaMBfUrLBcQmobXogd2yAj+IVRvrYh/P/ILrXcWUy6qt1/Ej7rfGyPwALxR1wGboN1jDN8DCzaJ2Nug/RrZsPzb8spdiwyiOSVVZVuozfc1WLBNhN8N7Rfwnws75lb34eEfFhySLY6RuVywndj3XYAFu0X4f0A7tmZJaUILyseb+MFNfmiZacQWDWgt9Xs8bpbzZn9U76AdXWpaexRMob28/F5i99ODFnzoqvTdHOCmk7cl2z2u0EL8NrIhxHkCm6nNF+o81FVtROO7mXghZ58N+dV0i58537H4aQ+cO1i+MsFclnWyJshPG2OaHHTewVj+Wb4wX+mk82/j8Dm3LSN0foT1fBeH/5bOczyQ38xpyyHjORzLL3H4ihr+IKethIyXcCwDRvGZrhVRFRmv4lgeGcX3cdrKyHgZx/K3UXzObaOyhYx/w7H0auPXFsdkn2+rY+NBagCwcA6m6+fb7LBgrQifvUrLDzO122lPO8tnd05F2viggy49wxxsFszQHmaI0c6303NDI+tppCyBL43jg+IponYPZ0ueQkyRylQJaxHjX3XFhP0lxfgTaOMepljxSXK8GKPCgldF+Ej4R032jlgnHKvm0aOqjs1T4Q479rPu9/+T8uvcPv9gc0Wcg7i0iuZBv89dl0/8ahBfsz4L/izHk0D+DG16Lpf/nDZdksu/RJuyn8rkP2WvBFYPyOMPrOb5tta6fozoWeL4z6L1XbVb49r7E8fvF7Gb/P8K/8ouQ3RFHf8G87oYphsi/MuJ418W4R9IHP+ACH/Fot+YaFVQ7BqNs90wRnVCeGBlr5AN0bDoHaDtRSLwL8S/TbLRV98GaEjNp1FWp8ZvXhZSwKnyAjat9GJn34Ah6uu8WKrq9tyUKVOmTJlKtP4Fcubyhw==",
  terminal:
    "eJzt20tME0EYAOC1RYIkRinEECtKUAgJaX1EQy1UfMRoCvEVMCaGeOKqd682XLEhHDx4bQJX6YlgxINRCKkxkkpMVKglxEd5lUcBu1K682B3W2ZmZ1gN+9+Waff7aWd3/93+I0lWWGGFFVgU+zvD0URK5hSpRDTc6S8m1T2hJC8Zj2TIQ6K7BkXg2Rh0bafbA+vieFleD9jz8o4hkXomhhx5eOeYaF6Wx5y5//sd4DcSyPUJ2Ld8+IuRgX5OMRDZckAN5ZgDAfSSpR5vQd6JQhl2z9N5tPeA7mtcaOb3lfPEs+F4Bne/rnsYvgTD6Yf89UzcWQLCoM6oB6bXIYaXJB9MQOdMGAJjXaL4jU8AGCHNUDGYouOF4nwJzIGk5mLkB6m1CuQlBzgK/OqRTmVg0ibSl4IK06keCCsDQaE8nOVh9UBUGWgT69uVaRZVDyQU3y3WlyJZJqH+Oyi2cl+d+MRAlkmp/w6mf5lgv19xLN/yLd/yLf8f9d2hb5PPS03z/ZsXxJEDJvm2eHbzHe8ECP1qsM07AUK/QhaUAOn3/xEmMMw1AVK/aVXMJ0B8/N1MCUmA/PzTvCIiAYrz37VlAQnQnH+vLPJPgOr835TkngDd9adxnncClNc/zyznBGivv2cTfBOgvv6f/sU1Afr6w/2DZwIM9U/dNMcEWOqv2il+CTDVf9UxmIDRqyFb/Vk1wSsBxvr32BdOCbDW3xWf+STAXP8f/sQlAfb7j/IxHgkYuP859AEm8KbIBF8qjcAEHpvhSyWwKh42xb8EC6JRM/yLqB57YoKP8VP7d97HisE/D1h5dh/j1+8z88z+BYy/x86z+hi/ZugnCjbfh/jV20Z4Nt+3APnUDUM8k9+I+JVmYzyLj/HL1w3yDH4D4peuGuXp/QZ0C7h42TBP7XsRn2wyztP6GL/g48BT+ucRP+flwdP5GD9bz4Wn8j1zkJ85x4en8TH+9xlOPIVfj/ifp/R2VVDiIAu8lYfYx/gfev0yNS/QE9JtYi1cQ+270IOf6TodvjahVvLFDNwFqT8K3ztVq8OjbiGyeEvpV8J3xmvUL83EwTSdLx+l891gO3ZCj5eOUPLySTq/SJl9E1W6vGT7TsfP76PzpY7Nra+V+rwk3aLr04Q9XcTHX8tIWn59PBe/UZW8Is4gPdwC30Zx/ivc5iZ7L+n5B+/o+m9+/9xlvtn9RzvVf/U+y2j6r0D/2V2xfIHyDEHTfwb677rF+l6F0fTfgf7DONe+X030KIym/xD2X7aL5MtBB6ym/xL2n8aYH+0QRJ+CaPtPUf9t7x5h/CNgaPtvsf7joKgEOmDRorcSA1VUvUK+gsIuCOj1X+P957F27keBrXUc7l6//xzvv5fj3W1uZxmncLrbgjFs5/r996r1B+Ii1/oDs9dfmL7+xPT1N6avP5LMXn+VCXPXn2XC3PV3VlhhxS6Jv/aIuJE=",
  folder:
    "eJzt2ltIVEEYB/DZNCsvlJYkCZUhaBfIMCy6PZkX8pZIGL3UY/USgfrkQ4+mRRZdCCIhu6APkkhZWWBKrVbWQxmW7mppD2sIW3nZ1XVa2znn6O7OnjkzZ4Li+z/uzHy/b8+es3v0DEIQCAQCgUAg3ljSTl5/+t424p/vw+1nkqXrSdVfMD2eunipeuKtmRD6XEZ2SuRP/NTRvRnfL0tf1qCvezOZJYdf0cnEy2og8gUjL6cBy/0FhONDj1/ejkptoEyr7mkqWRmsw8NT8hpIcam1n2+mTcqT10CrWrlqEX1W5rikBnaodStDztv7Q04Dd5WqdToTM8ZkNBAzQWoORulNTXNIaKBQKVmqP3fjN/MbOE8KDoU499QkD2kN5EbrZjFDySekXg1Tt+v6sZG4h9svHooNWdFGphYw+WhNr6EG5uJqDvWz6SSzUtl8FP/OcAMYd9PvHJSbjgRGH8V+5GhgtjaCUk6ZsYrVL57m8DF+tdocv8jNxWM8kGSGX8jLY9wf9AgY8wv4eYy7gn0fGPLztZ9qV0mCbtZuK700PK+Bc4J+nsa7Gb8vUFhJn7rIky7kH+DgvYmoUZd1ivi5U1y8N8c8ysJ9/H4ON4/QcWVlA7efLcAjVE+WTkRz+lmTIjyK/0UW59P8zHR6tmdWu4V4hGrJ6iqazxo+HmWQ5Q8EfU4ehZE/r/vEfF4eoR5fgTEhn59Hj30VXCL+eMDZy54WUkPA703j58V9R8USAV7X/zpEz+CnjisHhXR9n/n+D3zwwQcffPDBBx988MEHH3zwwQcf/H/KV54/Uh7PmZaHPmbG/3Xl+WuKZN/qY5z+r9uJnyeXt5DNE3b/gTbiB/xj3txsJUyb/4Cy/2DAItU/S5gL/gNFygVQLJOPc9IUdf/J56US/RsEmVweMHRPOQDX5PFHFKMxcEzbf3RaFp+jPjjdE2RU239VKeccPKryz4INz9t/1rrBfD1R/YDx9JagM8qxNqM+V3cblJFEZt/UnpvSNphZmvG8zNi6O0xKt23BltpHtC1OUVb8F/ImhnqY4l7K51+H2r4c2SSbb6G/+z85NaFfgz9TZbqX9vrGWVn6bBPTdZ162aFfy3hGr25i0ecSvqv8ttXucJoUh916p2J3OKsOgUAgEAjkP89vrC1F4g==",
} as const;
const masks = new Map<string, Uint8Array>();
export function stateIconMask(glyph: string): Uint8Array | undefined {
  const name =
    glyph === icons.robot
      ? "robot"
      : glyph === icons.terminal
        ? "terminal"
        : glyph === icons.folder
          ? "folder"
          : undefined;
  if (!name) return undefined;
  let mask = masks.get(name);
  if (!mask) {
    mask = inflateSync(Buffer.from(compressed[name], "base64"));
    if (mask.length !== stateIconSize ** 2) throw new Error("Invalid embedded state icon mask.");
    masks.set(name, mask);
  }
  return mask;
}
