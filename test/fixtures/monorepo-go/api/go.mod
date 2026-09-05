module example.com/acme/api

go 1.24

require (
	example.com/acme/core v0.0.0
	github.com/lib/pq v1.10.9 // indirect
)

replace example.com/acme/core => ../core
