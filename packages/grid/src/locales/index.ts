/**
 * Every set of texts that vastgrid has (react.md §2 and §5.1): `vastgrid/locales/<tag>` gives one alone, so that a
 * page bundles only the languages it shows. This module gives them all, for hosts that follow the user's language.
 */
import type { GridMessages } from "../react/messages.js";
import { de } from "./de.js";
import { en } from "./en.js";
import { es } from "./es.js";
import { fr } from "./fr.js";
import { ja } from "./ja.js";
import { ko } from "./ko.js";
import { ptBR } from "./pt-BR.js";
import { zhHans } from "./zh-Hans.js";
import { zhHant } from "./zh-Hant.js";

export { de, en, es, fr, ja, ko, ptBR, zhHans, zhHant };

/**
 * The texts for a BCP 47 tag, by its language: Chinese in traditional characters for `zh-Hant`, `zh-TW`, `zh-HK`
 * and `zh-MO`, in simplified ones for any other `zh`, Brazilian Portuguese for any `pt`, and English for a
 * language that vastgrid does not have.
 */
export function messagesFor(locale: string | undefined): GridMessages {
  const [language = "", ...rest] = (locale ?? "").toLowerCase().split(/[-_]/);
  switch (language) {
    case "de":
      return de;
    case "es":
      return es;
    case "fr":
      return fr;
    case "ja":
      return ja;
    case "ko":
      return ko;
    case "pt":
      return ptBR;
    case "zh":
      return rest.some((part) => ["hant", "tw", "hk", "mo"].includes(part)) ? zhHant : zhHans;
    default:
      return en;
  }
}
