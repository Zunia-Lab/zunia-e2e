// Prints, one per line, what Go's encoding/json writes for each string of the
// JSON array read from stdin. Cosmos SDK x/tx aminojson writes every string of
// an amino document this way (signing/aminojson/json_marshal.go), so this is
// the escaping a chain applies when it rebuilds the bytes a wallet signed.
//
//	echo '["a & b <c>"]' | go run escape.go
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	var inputs []string
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		fmt.Fprintln(os.Stderr, "stdin must be a JSON array of strings:", err)
		os.Exit(2)
	}
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for _, input := range inputs {
		encoded, err := json.Marshal(input)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Fprintln(out, string(encoded))
	}
}
