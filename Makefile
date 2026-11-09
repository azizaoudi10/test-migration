.PHONY: test lint typecheck build clean install

PNPM := pnpm
DESKTOP_FILTER := --filter @fraktole/desktop
MOBILE_DIR := apps/mobile

install:
	$(PNPM) install --frozen-lockfile

test:
	$(PNPM) -r test

lint:
	$(PNPM) -r lint

typecheck:
	$(PNPM) -r typecheck

build:
	$(PNPM) -r build
	$(PNPM) $(DESKTOP_FILTER) -- appimage
	cd $(MOBILE_DIR) && flutter build apk --release

clean:
	$(PNPM) -r clean
	rm -rf apps/desktop/release
	rm -rf apps/desktop/dist-electron
	rm -rf apps/desktop/dist-renderer
	rm -rf apps/mobile/build
	find . -name node_modules -type d -prune -exec rm -rf {} +
	find . -name .pub-cache -type d -prune -exec rm -rf {} +
	find . -name .dart_tool -type d -prune -exec rm -rf {} +
