# LLM Hub

.PHONY: help up up-gpu down logs restart retune gpu-check models

help:
	@echo "make up         start the stack (CPU)"
	@echo "make up-gpu     start the stack with the NVIDIA GPU"
	@echo "make down       stop the stack"
	@echo "make logs       follow the engine logs"
	@echo "make restart    restart with the settings in .env"
	@echo "make retune     re-profile the hardware and update .env"
	@echo "make gpu-check  can the container see the GPU?"
	@echo "make models     list downloaded models"

up:
	./scripts/autotune.sh || true
	docker compose up -d

up-gpu:
	./scripts/autotune.sh || true
	docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

down:
	docker compose down

logs:
	docker compose logs -f llama

restart:
	docker compose up -d --force-recreate

retune:
	./scripts/autotune.sh
	docker compose up -d --force-recreate

gpu-check:
	docker compose exec llama nvidia-smi || echo "No GPU visible to the container."

models:
	curl -s http://localhost:${LLAMA_PORT:-8081}/downloader/api/models || echo "Runner not reachable."
