import { openExternalUrl } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

/**
 * Opens a link in the reviewer's own browser: `Linking.openURL` opens a web URL inside Paseo, and
 * the host's external opener takes only HTTP(S), so anything else, like `mailto:`, goes to `Linking`.
 */
export function openLink(url: string): Promise<void> {
  return /^https?:/i.test(url) ? openExternalUrl(url) : Linking.openURL(url);
}
