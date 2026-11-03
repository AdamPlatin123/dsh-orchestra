// The DSH seat bundle's own tests (integrations/dsh-seat, outside src/shared/ui and every repo scan) run in
// the repo suite too: importing the file registers its node:test cases in this run.
import '../../integrations/dsh-seat/test/provider.test.mjs';
