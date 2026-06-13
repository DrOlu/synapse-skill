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
		"Bob's Agent",
		"Friendly chat agent",
		[]string{"chat"},
		[]synapse.Skill{
			{ID: "chat", Name: "Chat", Description: "Chat with Bob"},
		},
	)
	if err != nil {
		log.Fatalf("Failed to register: %v", err)
	}

	mesh.OnRequest("chat", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		text, _ := input["text"].(string)

		fmt.Printf("[Bob] Received: '%s'\n", text)

		return map[string]interface{}{
			"text": fmt.Sprintf("Bob says: I got your message! You said '%s'", text),
		}, nil
	})

	fmt.Println("Bob agent online, waiting for requests...")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("\nShutting down...")
}
