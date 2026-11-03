COMPOSE ?= docker compose
GPU_FILES = -f docker-compose.yml -f docker-compose.gpu.yml

.PHONY: help up up-gpu down restart logs ps gpu-check models autotune retune hardware clean

help:
	@echo "make up        - profile this machine, then start the stack on CPU"
	@echo "make up-gpu    - same, with GPU passthrough (needs nvidia-container-toolkit)"
	@echo "make down      - stop the stack"
	@echo "make restart   - stop, re-profile, start"
	@echo "make logs      - follow logs"
	@echo "make ps        - container status"
	@echo "make gpu-check - ask the container what GPU it can see"
	@echo "make models    - list downloaded models"
	@echo "make autotune  - re-profile the host and update the tuning in .env"
	@echo "make retune    - re-profile the host only (no .env changes)"
	@echo "make hardware  - show the detected hardware profile"
	@echo "make clean     - stop the stack and delete downloaded models"

# Always profile before starting, so the GUI's fit badges describe this
# machine rather than whatever was detected last time. Cheap and side-effect
# free: it only writes webgui/hardware.json.
up: retune
	$(COMPOSE) up -d
	@echo
	@echo "GUI:        http://localhost:$${WEBGUI_PORT:-8080}"
	@echo "Ollama API: http://localhost:$${OLLAMA_PORT:-11435}"

up-gpu: retune
	$(COMPOSE) $(GPU_FILES) up -d
	@echo
	@echo "GUI:        http://localhost:$${WEBGUI_PORT:-8080}"
	@echo "Ollama API: http://localhost:$${OLLAMA_PORT:-11435}"

down:
	$(COMPOSE) $(GPU_FILES) down

restart: down up

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) $(GPU_FILES) ps

gpu-check:
	@docker exec llm-hub-ollama sh -c 'nvidia-smi -L || echo "no GPU visible inside the container"'

models:
	@curl -s http://localhost:$${OLLAMA_PORT:-11435}/api/tags | python3 -m json.tool 2>/dev/null || echo "stack not up?"

# Re-profile and rewrite the managed tuning block in .env. Needs a restart
# (make restart) for the new values to reach the container.
autotune:
	@scripts/autotune.sh --apply

# Refresh the profile the GUI reads. Safe to run any time.
retune:
	@scripts/autotune.sh

hardware:
	@scripts/autotune.sh --print

clean:
	$(COMPOSE) $(GPU_FILES) down -v
