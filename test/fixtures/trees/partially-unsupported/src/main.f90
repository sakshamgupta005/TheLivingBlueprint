program numerical_solver
  use math_module
  implicit none
  real(8) :: result
  print *, "Starting legacy solver..."
  result = compute_integral(0.0d0, 1.0d0)
  print *, "Result: ", result
end program numerical_solver
