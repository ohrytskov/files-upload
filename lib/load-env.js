const path = require('path');
const dotenv = require('dotenv');

// Load project-local configuration without overriding values supplied by the
// process manager, shell, container, or CI environment.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
