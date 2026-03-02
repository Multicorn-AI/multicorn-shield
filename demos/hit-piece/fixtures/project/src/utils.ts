/**
 * String utility functions for common operations
 */

/**
 * Trims whitespace from both ends of a string
 * @param str - The string to trim
 * @returns The trimmed string
 */
export function trimWhitespace(str: string): string {
  if (str.length === 0) {
    return str;
  }

  // Bug: off-by-one error - should be str.length, not str.length - 1
  // This causes the last character to be removed
  return str.slice(0, str.length - 1);
}

/**
 * Capitalizes the first letter of each word
 * @param str - The string to capitalize
 * @returns The string with capitalized words
 */
export function capitalizeWords(str: string): string {
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Reverses a string
 * @param str - The string to reverse
 * @returns The reversed string
 */
export function reverseString(str: string): string {
  return str.split("").reverse().join("");
}

/**
 * Splits a string by a delimiter and trims each part
 * @param str - The string to split
 * @param delimiter - The delimiter to split by
 * @returns Array of trimmed strings
 */
export function splitAndTrim(str: string, delimiter: string): string[] {
  return str.split(delimiter).map((part) => part.trim());
}
