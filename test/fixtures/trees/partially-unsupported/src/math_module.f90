module math_module
  implicit none
contains
  function compute_integral(a, b) result(val)
    real(8), intent(in) :: a, b
    real(8) :: val
    val = (b - a) * 0.5d0
  end function compute_integral
end module math_module
