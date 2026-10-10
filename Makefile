# Filename: Makefile
SBX         ?= kiro-llm
WORK        ?= /scratch/llm
PRJ         ?= sbx-kiro
KIT_DIR     ?= $(shell pwd)/kiro-kit
SPEC_FILE   ?= $(KIT_DIR)/spec.yml
IMAGE       ?= docker.io/sbx/kiro-kit:latest
SBX_BIN     ?= /usr/bin/sbx
SHELL_BIN   ?= /bin/bash
DAEMON_LOG  ?= /tmp/sbx.log

define FETCH_STATUS
	EXISTS=$$(sbx ls 2>/dev/null | grep -E "^$(SBX)[[:space:]]" | head -n 1); \
	STOPPED=$$(echo "$$EXISTS" | grep "stopped" | head -n 1)
endef

.PHONY: run start stop status shell spush spull purge rebuild sbx-start sbx-stop sbx-restart sbx-status

status:
	@$(FETCH_STATUS); \
	if [ -n "$$STOPPED" ]; then \
		echo "Sandbox '$(SBX)' is stopped. Start it with 'make run'"; \
	elif [ -n "$$EXISTS" ]; then \
		echo "'$(SBX)' is running."; \
	else \
		echo "'$(SBX)' does not exist. Use 'make start' to create it."; \
		exit 0; \
	fi

# Run the sandbox if it exists and is stopped
# New changes to spec.yml won't be applied 
run:
	@$(FETCH_STATUS); \
	if [ -n "$$STOPPED" ]; then \
		echo "Sandbox '$(SBX)' is stopped. Starting existing instance..."; \
		$(SBX_BIN) run --name $(SBX); \
	elif [ -n "$$EXISTS" ]; then \
		echo "Sandbox '$(SBX)' is already running."; \
	else \
		echo "Sandbox '$(SBX)' does not exist. Use 'make start' to create it."; \
		exit 1; \
	fi

# Changing spec.yml requires a rebuild of the sandbox to apply changes. Use 'make rebuild' to purge and 'start' to recreate
start:
	@$(FETCH_STATUS); \
	if [ -z "$$EXISTS" ]; then \
		echo "Creating and starting sandbox '$(SBX)'..."; \
		$(SBX_BIN) run $(IMAGE) --name $(SBX) --kit $(KIT_DIR) $(WORK); \
	else \
		echo "Sandbox '$(SBX)' already exists. Use 'make run' to execute or attach."; \
		exit 0; \
	fi

stop:
	@$(FETCH_STATUS); \
	if [ -n "$$EXISTS" ] && [ -z "$$STOPPED" ]; then \
		echo "Stopping sandbox '$(SBX)'..."; \
		$(SBX_BIN) stop $(SBX); \
	elif [ -n "$$STOPPED" ]; then \
		echo "Sandbox '$(SBX)' is already stopped."; \
	else \
		echo "Sandbox '$(SBX)' does not exist."; \
	fi

shell:
	$(SBX_BIN) exec -it $(SBX) $(SHELL_BIN)

sbx-start:
	nohup $(SBX_BIN) daemon start 2>&1 | tee $(DAEMON_LOG) &

sbx-stop:
	$(SBX_BIN) daemon stop

sbx-restart:
	$(SBX_BIN) daemon restart

sbx-status:
	$(SBX_BIN) daemon status

spush:
	rsync -av ./ $(WORK)/$(PRJ)/ --exclude=.git --exclude=*pycache*

spull:
	rsync -av $(WORK)/$(PRJ)/ ./ --exclude=.git --exclude=*pycache*

purge:
	$(SBX_BIN) rm $(SBX) --force 2>/dev/null || true

rebuild: purge start

# ---------------------------------------------------------------------------
# sbx Manager web app (local stdlib server on 127.0.0.1:8123)
# Distinct target names so they don't collide with the sandbox lifecycle
# targets above (run/start/stop manage the sbx sandbox, not this web app).
# ---------------------------------------------------------------------------
PYTHON   ?= python3
APP_HOST ?= 127.0.0.1
APP_PORT ?= 8123
APP_PID  ?= /tmp/sbx-manager.pid
APP_LOG  ?= /tmp/sbx-manager.log

.PHONY: serve serve-bg serve-stop serve-status app-restart test test-v

# Run the web app in the foreground (Ctrl-C to stop).
serve:
	$(PYTHON) -m app.server

# Run the web app in the background, recording its PID.
serve-bg:
	@if [ -f $(APP_PID) ] && kill -0 $$(cat $(APP_PID)) 2>/dev/null; then \
		echo "sbx Manager already running (PID $$(cat $(APP_PID)))."; \
	else \
		nohup $(PYTHON) -m app.server >$(APP_LOG) 2>&1 & echo $$! >$(APP_PID); \
		sleep 1; \
		echo "sbx Manager started on http://$(APP_HOST):$(APP_PORT) (PID $$(cat $(APP_PID))), log: $(APP_LOG)"; \
	fi

serve-stop:
	@if [ -f $(APP_PID) ] && kill -0 $$(cat $(APP_PID)) 2>/dev/null; then \
		kill $$(cat $(APP_PID)) && rm -f $(APP_PID); \
		echo "sbx Manager stopped."; \
	else \
		echo "sbx Manager is not running (no live PID in $(APP_PID))."; \
		rm -f $(APP_PID); \
	fi

serve-status:
	@if [ -f $(APP_PID) ] && kill -0 $$(cat $(APP_PID)) 2>/dev/null; then \
		echo "sbx Manager running (PID $$(cat $(APP_PID))) on http://$(APP_HOST):$(APP_PORT)."; \
	else \
		echo "sbx Manager is not running."; \
	fi

app-restart: serve-stop serve-bg

# Run the unit test suite.
test:
	$(PYTHON) -m unittest discover -s tests

test-v:
	$(PYTHON) -m unittest discover -s tests -v

# vim: set noexpandtab:
