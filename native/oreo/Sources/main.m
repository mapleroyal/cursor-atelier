#import "OreoAppController.h"
#import "OreoAppDelegate.h"
#import <Cocoa/Cocoa.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        int commandResult = OreoRunCommandLineIfRequested(argc, argv);
        if (commandResult >= 0) {
            return commandResult;
        }

        NSApplication *application = [NSApplication sharedApplication];
        OreoAppDelegate *delegate = [[OreoAppDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
