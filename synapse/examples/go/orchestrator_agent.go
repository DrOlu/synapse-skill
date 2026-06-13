package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/synapse-go/examples/synapse"
)

var mesh *synapse.Synapse

func main() {
	var err error
	mesh, err = synapse.Connect("nats://localhost:4222")
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer mesh.Close()

	err = mesh.Register(
		"Orchestrator",
		"Coordinates research and summarization",
		[]string{"orchestration"},
		[]synapse.Skill{
			{ID: "research-project", Name: "Research Project", Description: "Full research + summary"},
		},
	)
	if err != nil {
		log.Fatalf("Failed to register: %v", err)
	}

	mesh.OnRequest("research-project", func(payload map[string]interface{}, ctx map[string]string) (interface{}, error) {
		input, _ := payload["input"].(map[string]interface{})
		topic, _ := input["topic"].(string)
		fmt.Printf("[Orchestrator] Starting research on: '%s'\n", topic)

		// Step 1: Discover research agent
		researchers, err := mesh.Discover([]string{"research"}, 2*time.Second)
		if err != nil || len(researchers) == 0 {
			return nil, fmt.Errorf("no research agents available")
		}
		researcher := researchers[0]
		fmt.Printf("[Orchestrator] Delegating to researcher: %s\n", researcher.Name)

		// Step 2: Request research
		researchResult, err := mesh.Request(researcher.ID, "research", map[string]interface{}{
			"topic": topic,
		}, 60*time.Second)
		if err != nil {
			return nil, fmt.Errorf("research failed: %w", err)
		}

		findings, _ := researchResult.Payload["output"].(map[string]interface{})
		findingsList, _ := findings["findings"].([]interface{})
		fmt.Printf("[Orchestrator] Research complete (%d findings)\n", len(findingsList))

		// Step 3: Discover summarizer
		summarizers, err := mesh.Discover([]string{"summarize"}, 2*time.Second)
		if err != nil || len(summarizers) == 0 {
			return nil, fmt.Errorf("no summarizer agents available")
		}
		summarizer := summarizers[0]
		fmt.Printf("[Orchestrator] Delegating to summarizer: %s\n", summarizer.Name)

		// Step 4: Request summary
		summaryResult, err := mesh.Request(summarizer.ID, "summarize", map[string]interface{}{
			"findings": findingsList,
			"format":   "brief",
		}, 30*time.Second)
		if err != nil {
			return nil, fmt.Errorf("summarize failed: %w", err)
		}

		summaryOutput, _ := summaryResult.Payload["output"].(map[string]interface{})
		fmt.Println("[Orchestrator] Summary generated")

		return map[string]interface{}{
			"topic":           topic,
			"findings":        findingsList,
			"summary":         summaryOutput["summary"],
			"research_agent":  researcher.Name,
			"summarize_agent": summarizer.Name,
		}, nil
	})

	fmt.Println("Orchestrator agent online")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("\nShutting down...")
}
