package main

import "encoding/hex"

// hexDecode reads a hexadecimal object id into its twenty raw bytes.
func hexDecode(s string) ([]byte, error) {
	return hex.DecodeString(s)
}
