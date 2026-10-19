import type { BenchmarkFixture } from './types.ts';

export const unsupportedFixture: BenchmarkFixture = {
  id: 'fixture-partially-unsupported',
  name: 'Partially Unsupported Project',
  owner: 'benchmark-org',
  repo: 'legacy-fortran-solver',
  defaultBranch: 'main',
  commitSha: 'f60718293a4b5c6d7e8f90123456789012345a6b',
  checkRuns: [],
  files: {
    'package.json': `{
  "name": "broken-manifest",
  "version": "1.0.0",
  // Syntax error: unquoted trailing property and missing closing brace
  broken_field: true,
`,
    'README.md': `# Legacy Fortran Numerical Solver\n\nHigh performance numerical integration solver written in Fortran 90 with legacy Makefile driver.`,
    'src/main.f90': `program numerical_solver
  use math_module
  implicit none
  real(8) :: result
  print *, "Starting legacy solver..."
  result = compute_integral(0.0d0, 1.0d0)
  print *, "Result: ", result
end program numerical_solver
`,
    'src/math_module.f90': `module math_module
  implicit none
contains
  function compute_integral(a, b) result(val)
    real(8), intent(in) :: a, b
    real(8) :: val
    val = (b - a) * 0.5d0
  end function compute_integral
end module math_module
`,
    'Makefile': `FC = gfortran
FFLAGS = -O3 -Wall

all: solver

solver: src/math_module.f90 src/main.f90
\t$(FC) $(FFLAGS) -o solver src/math_module.f90 src/main.f90

clean:
\trm -f solver *.mod
`,
    'config/legacy.cfg': `[solver_parameters]
tolerance = 1e-9
max_iterations = 5000
damping_factor = 0.85
`,
    'assets/data.bin': `BINARY_DATA_NON_TEXT_PAYLOAD_\x00\x01\x02\x03`,
  },
  knownFacts: {
    name: 'Partially Unsupported Project',
    description: 'Repository in Fortran 90 with malformed JSON manifest and unsupported native build toolchain.',
    entryPoints: ['src/main.f90'],
    routes: [],
    imports: [
      { from: 'src/main.f90', to: 'src/math_module.f90' },
    ],
    tests: [],
    workflows: [],
    expectedRelationships: [],
    expectedRooms: ['room-core'], // Gracefully maps to core repository room
    unsupportedOrUncertainFacts: [
      'Fortran 90 language has no native AST or framework heuristic support',
      'package.json manifest has invalid JSON syntax and cannot be parsed',
      'Makefile build steps cannot be safely executed by scanner',
      'No CI check runs exist for legacy repository',
    ],
  },
};
