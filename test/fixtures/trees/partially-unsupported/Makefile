FC = gfortran
FFLAGS = -O3 -Wall

all: solver

solver: src/math_module.f90 src/main.f90
	$(FC) $(FFLAGS) -o solver src/math_module.f90 src/main.f90

clean:
	rm -f solver *.mod
