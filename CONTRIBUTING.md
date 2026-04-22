# Contributing

## Testing
For unit & single-workspace tests
```bash
npm run test
```

For testing with multiple workspaces from a clean environment you can use 
```bash
bash scripts/test-extension.sh <lean-workspace-1> <lean-workspace-2>
```

This will package the extension into a vsix and install it in the workspaces. 
It will also use a clean profile so it is as if the extension was installed from scratch.



