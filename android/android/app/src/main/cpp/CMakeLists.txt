# The on-phone chat engine (LocalAiPlugin): llama.cpp built for arm64 phones.
cmake_minimum_required(VERSION 3.22.1)
project(arcflare_llm C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# llama.cpp (MIT, The ggml authors), pinned: release b12387 is commit a956a852. The tag is fetched with git and the
# build stops if it ever points at another commit.
set(LLAMA_TAG b12387)
set(LLAMA_COMMIT a956a852c9c8bc1fb07206364838ddef299178c0)

# Only what the app needs: the library and its common helpers. No tools, server, tests, network or UI.
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
foreach(off LLAMA_BUILD_TESTS LLAMA_BUILD_TOOLS LLAMA_BUILD_EXAMPLES LLAMA_BUILD_SERVER LLAMA_BUILD_APP
            LLAMA_BUILD_UI LLAMA_USE_PREBUILT_UI LLAMA_CONNECT LLAMA_OPENSSL LLAMA_SUBPROCESS LLAMA_LLGUIDANCE
            GGML_NATIVE GGML_LLAMAFILE GGML_CPU_KLEIDIAI)
    set(${off} OFF CACHE BOOL "" FORCE)
endforeach()
# One CPU backend per generation of ARM core (plain ARMv8, dotprod, i8mm, SVE, ...). The engine loads them all at
# start and ggml picks the best one this phone's CPU supports, so one APK is tuned for every chip.
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
# ggml's own thread pool: OpenMP would need libomp.so packaged next to the engine.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

include(FetchContent)
FetchContent_Declare(llama GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git GIT_TAG ${LLAMA_TAG} GIT_SHALLOW TRUE)
FetchContent_GetProperties(llama)
if(NOT llama_POPULATED)
    FetchContent_Populate(llama)
    execute_process(COMMAND git rev-parse HEAD WORKING_DIRECTORY ${llama_SOURCE_DIR}
                    OUTPUT_VARIABLE got OUTPUT_STRIP_TRAILING_WHITESPACE)
    if(NOT got STREQUAL LLAMA_COMMIT)
        message(FATAL_ERROR "llama.cpp ${LLAMA_TAG} is ${got}, expected ${LLAMA_COMMIT}: refusing to build it")
    endif()
    add_subdirectory(${llama_SOURCE_DIR} ${llama_BINARY_DIR})
endif()

add_library(arcflare_llm SHARED arcflare_llm.cpp)
target_include_directories(arcflare_llm PRIVATE ${llama_SOURCE_DIR}/common ${llama_SOURCE_DIR}/include)
target_link_libraries(arcflare_llm llama llama-common log)
