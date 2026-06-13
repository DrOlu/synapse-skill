package main

import (
	"fmt"
	"log"
	"time"

	"github.com/synapse-go/examples/synapse"
)

func main() {
	mesh, err := synapse.Connect("nats://localhost:4222")
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer mesh.Close()

	mesh.Register("Jeff's Agent", "", nil, nil)

	agents, err := mesh.Discover([]string{"chat"}, 2*time.Second)
	if err != nil || len(agents) == 0 {
		log.Fatal("Could not find Bob!")
	}

	bob := agents[0]
	fmt.Printf("Found Bob: %s\n", bob.ID)

	response, err := mesh.Request(bob.ID, "chat", map[string]interface{}{
		"text": "Hey Bob, how's it going?",
	}, 30*time.Second)

	if err != nil {
		log.Fatalf("Request failed: %v", err)
	}

	fmt.Printf("Bob's response: %v\n", response.Payload)
}
