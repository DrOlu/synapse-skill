package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/synapse-go/examples/synapse"
)

func main() {
	mesh, err := synapse.Connect("nats://localhost:4222")
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer mesh.Close()

	err = mesh.Register(
		"Utilities Agent",
		"Common text and math utilities",
		[]string{"text", "math"},
		[]synapse.Skill{
			{ID: "uppercase", Name: "Uppercase", Description: "Convert to uppercase"},
			{ID: "reverse", Name: "Reverse", Description: "Reverse a string"},
			{ID: "strlen", Name: "String Length", Description: "Count characters"},
			{ID: "add", Name: "Add", Description: "Add two numbers"},
			{ID: "multiply", Name: "Multiply", Description: "Multiply two numbers"},
		},
	)
	if err != nil {
		log.Fatalf("Failed to register: %v", err)
	}

	mesh.OnRequest("uppercase", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		text, _ := input["text"].(string)
		return map[string]interface{}{"text": toUpper(text)}, nil
	})

	mesh.OnRequest("reverse", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		text, _ := input["text"].(string)
		return map[string]interface{}{"text": reverse(text)}, nil
	})

	mesh.OnRequest("strlen", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		text, _ := input["text"].(string)
		return map[string]interface{}{"length": len(text)}, nil
	})

	mesh.OnRequest("add", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		a, _ := toFloat(input["a"])
		b, _ := toFloat(input["b"])
		return map[string]interface{}{"result": a + b}, nil
	})

	mesh.OnRequest("multiply", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		a, _ := toFloat(input["a"])
		b, _ := toFloat(input["b"])
		return map[string]interface{}{"result": a * b}, nil
	})

	fmt.Println("Utilities agent online with 5 skills")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("\nShutting down...")
}

func toUpper(s string) string {
	result := make([]rune, len(s))
	for i, r := range s {
		if r >= 'a' && r <= 'z' {
			result[i] = r - 32
		} else {
			result[i] = r
		}
	}
	return string(result)
}

func reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}

func toFloat(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}
