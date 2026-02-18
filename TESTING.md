# Testing the Consent Component Locally

This guide explains how to test the `<multicorn-consent>` web component locally.

## Prerequisites

- Node.js 20+
- pnpm 9+ (or npm/yarn)

## Step 1: Install Dependencies

```bash
cd multicorn-shield
pnpm install
```

## Step 2: Run Unit Tests

Test the component's functionality with Vitest:

```bash
# Run all tests once
pnpm test

# Run tests in watch mode (re-runs on file changes)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

After running coverage, open `coverage/lcov-report/index.html` in your browser to see detailed coverage.

## Step 3: Build the Component

Build the component for testing in a browser:

```bash
# Build once
pnpm build

# Build in watch mode (rebuilds on file changes)
pnpm dev
```

This creates the `dist/` folder with compiled JavaScript.

## Step 4: Test in Browser

You have two options for testing in a browser:

### Option A: Use a Local Dev Server (Recommended)

Since the component uses ES modules, you need a local server. Here are a few options:

#### Using Python (if installed):

```bash
# Python 3
python3 -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000
```

Then open: `http://localhost:8000/examples/test-consent.html`

#### Using Node.js `http-server`:

```bash
# Install globally
npm install -g http-server

# Run in the multicorn-shield directory
http-server -p 8000
```

Then open: `http://localhost:8000/examples/test-consent.html`

#### Using Vite (if you have it):

```bash
# Install vite globally
npm install -g vite

# Run in the multicorn-shield directory
vite --port 8000
```

Then open: `http://localhost:8000/examples/test-consent.html`

### Option B: Use the Built Version

If you've built the component (`pnpm build`), you can test with the built version:

1. Update `examples/test-consent.html` to import from `dist`:

   ```javascript
   import "../dist/index.js";
   ```

2. Serve the files with any HTTP server (see Option A above)

## Step 5: Interactive Testing

Once you have the test page open in your browser:

1. **Modal Mode Test**: Click "Open Modal Consent" to see the modal overlay
2. **Inline Mode Test**: The inline consent screen is already visible below
3. **Toggle Permissions**: Click the toggle switches or permission level buttons
4. **Test Events**: Click "Authorize" or "Deny" and watch the event log
5. **Keyboard Navigation**:
   - Press `Tab` to navigate between elements
   - Press `Space` or `Enter` to toggle switches
   - Press `Escape` in modal mode to deny
6. **Responsive**: Resize your browser to test mobile (375px) layout

## What to Test

### Visual Testing

- ✅ Dark theme matches Shield design system
- ✅ Agent name and color display correctly
- ✅ Icons and labels are human-readable
- ✅ Spending limit shows/hides correctly
- ✅ Modal backdrop appears in modal mode
- ✅ Responsive at 375px viewport

### Functional Testing

- ✅ Toggle switches work for individual scopes
- ✅ Permission level buttons toggle correctly
- ✅ "Authorize" emits correct event (granted/partial/denied)
- ✅ "Deny" button emits consent-denied event
- ✅ Escape key denies in modal mode
- ✅ Events include correct scope data

### Accessibility Testing

- ✅ Tab navigation cycles through all interactive elements
- ✅ Focus trap works in modal mode
- ✅ ARIA labels are present (check with screen reader)
- ✅ Keyboard shortcuts work (Space/Enter/Escape)

### Browser Compatibility

Test in:

- Chrome/Edge (Chromium)
- Firefox
- Safari
- Mobile browsers (iOS Safari, Chrome Mobile)

## Troubleshooting

### "Failed to load module" error

- Make sure you're using a local HTTP server (not `file://` protocol)
- Check that the import path in the HTML file is correct
- Verify `pnpm build` completed successfully

### Component doesn't render

- Check browser console for errors
- Verify Lit is installed: `pnpm list lit`
- Make sure the custom element is registered (check console for errors)

### Styles look broken

- Verify Shadow DOM is working (check in DevTools)
- Check that `consent-styles.ts` is being imported
- Look for CSS conflicts in browser DevTools

### Tests failing

- Run `pnpm install` to ensure all dependencies are installed
- Check that `jsdom` is installed: `pnpm list jsdom`
- Verify Vitest config has `environment: "jsdom"`

## Next Steps

- Check the component's JSDoc comments for API details
- Review `src/consent/multicorn-consent.test.ts` for test examples
- See `examples/test-consent.html` for usage examples
